import { useSelector, useDispatch } from 'react-redux';
import { useDebouncedCallback } from 'use-debounce';
import deepEqual from 'deep-equal';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { usePrevious } from 'web-common/hooks';
import { pick, noop } from 'web-common/utils';
import { getLastPageIndexSettingKey } from '../common/item';
import { Spinner } from 'web-common/components';
import { useFloating, flip, shift } from '@floating-ui/react-dom';
import PropTypes from 'prop-types';

import { annotationItemToJSON } from '../common/annotations.js';
import { ERROR_PROCESSING_ANNOTATIONS } from '../constants/actions';
import {
	deleteItems, fetchChildItems, fetchItemDetails, fetchLibrarySettings, navigate, tryGetAttachmentURL,
	patchAttachment, postAnnotationsFromReader, uploadAttachment, updateLibrarySettings,
	preferenceChange
} from '../actions';
import { PDFWorker } from '../common/pdf-worker.js';
import { useFetchingState } from '../hooks';
import { strings } from '../constants/strings.js';
import TagPicker from './item-details/tag-picker.jsx';
import { READER_CONTENT_TYPES } from '../constants/reader.js';
import Portal from './portal';

const PAGE_SIZE = 100;

const UNFETCHED = 0, NOT_IMPORTED = 0;
const FETCHING = 1, IMPORTING = 1;
const FETCHED = 2, IMPORTED = 2;

const PAGE_INDEX_KEY_LOOKUP = {
	'application/pdf': 'pageIndex',
	'application/epub+zip': 'cfi',
	'text/html': 'scrollYPercent'
};

import DiffWorker from 'web-worker:../diff.worker';

const cloneData = (data) => typeof structuredClone === 'function' ? structuredClone(data) : data.slice(0);

const computeDiffUsingWorker = (oldFile, newFile) => {
	return new Promise((resolve, reject) => {
		const dataWorker = new DiffWorker();
		dataWorker.postMessage(['LOAD', { oldFile: cloneData(oldFile), newFile: cloneData(newFile) }]);
		dataWorker.addEventListener('message', function (ev) {
			const [command, payload] = ev.data;
			switch (command) {
				case 'READY':
					dataWorker.postMessage(['DIFF']);
					break;
				case 'DIFF_COMPLETE':
					resolve(payload);
					break;
				case 'DIFF_ERROR':
					reject(payload);
					break;
				case 'LOG':
					console.warn(payload);
					break;
			}
		});
	});
};


const PopupPortal = memo(({ anchor, children, onClose }) => {
	const { x, y, refs, strategy, update } = useFloating({
		placement: 'bottom-start', middleware: [shift(), flip()]
	});
	const isOpen = children !== null;

	useLayoutEffect(() => {
		if (children !== null) {
			update();
		}
	});

	return (
		<Portal onClose={ onClose }>
			{isOpen && (
				<>
					<div className="anchor" ref={refs.setReference} style={{ position: 'absolute', left: anchor.x, top: anchor.y }} />
					<div className="popup" ref={refs.setFloating} style={{ position: strategy, transform: `translate3d(${x}px, ${y}px, 0px)` }}>
						{ children }
					</div>
				</>
			)}
		</Portal>
	);
});

PopupPortal.displayName = 'PopupPortal';
PopupPortal.propTypes = {
	anchor: PropTypes.shape({
		x: PropTypes.number.isRequired,
		y: PropTypes.number.isRequired,
	}),
	children: PropTypes.node,
	onClose: PropTypes.func.isRequired,
};

const readerReducer = (state, action) => {
	switch (action.type) {
		case 'BEGIN_FETCH_DATA':
			return { ...state, dataState: FETCHING };
		case 'COMPLETE_FETCH_DATA':
			return { ...state, dataState: FETCHED, data: action.data };
		case 'ERROR_FETCH_DATA':
			return { ...state, dataState: UNFETCHED, error: action.error };
		case 'BEGIN_IMPORT_ANNOTATIONS':
			return { ...state, annotationsState: IMPORTING };
		case 'COMPLETE_IMPORT_ANNOTATIONS':
			return { ...state, annotationsState: IMPORTED, importedAnnotations: action.importedAnnotations };
		case 'ERROR_IMPORT_ANNOTATIONS':
			return { ...state, annotationsState: IMPORTED, error: action.error };
		case 'SKIP_IMPORT_ANNOTATIONS':
			return { ...state, annotationsState: IMPORTED };
		case 'READY':
			return { ...state, isReady: true };
		case 'ROTATE_PAGES':
			return { ...state, action };
		case 'ROTATING_PAGES':
			return { ...state, action: null };
		case 'ROTATED_PAGES':
			return { ...state, action: null, data: action.data };
		default:
			return state;
	}
}


const Reader = () => {
	const dispatch = useDispatch();
	const iframeRef = useRef(null);
	const reader = useRef(null);
	const userLibraryKey = useSelector(state => state.current.userLibraryKey);
	const libraryKey = useSelector(state => state.current.libraryKey);
	const attachmentKey = useSelector(state => {
		if (state.current.attachmentKey) {
			return state.current.attachmentKey;
		} else if (state.current.itemKey) {
			return state.current.itemKey;
		} else {
			return null;
		}
	});
	const pageIndexSettingKey = getLastPageIndexSettingKey(attachmentKey, libraryKey);
	const locationValue = useSelector(state => state.libraries[userLibraryKey]?.settings?.entries?.[pageIndexSettingKey]?.value ?? null);
	const attachmentItem = useSelector(state => state.libraries[libraryKey]?.items[attachmentKey]);
	const isFetchingUrl = useSelector(state => state.libraries[libraryKey]?.attachmentsUrl[attachmentKey]?.isFetching ?? false);
	const url = useSelector(state => state.libraries[libraryKey]?.attachmentsUrl[attachmentKey]?.url);
	const timestamp = useSelector(state => state.libraries[libraryKey]?.attachmentsUrl[attachmentKey]?.timestamp ?? 0);
	const allItems = useSelector(state => state.libraries[libraryKey]?.items);
	const prevAttachmentItem = usePrevious(attachmentItem);
	const currentUserID = useSelector(state => state.config.userId);
	const currentUserSlug = useSelector(state => state.config.userSlug);
	const pdfWorkerURL = useSelector(state => state.config.pdfWorkerURL);
	const pdfReaderCMapsRoot = useSelector(state => state.config.pdfReaderCMapsRoot);
	const tagColors = useSelector(state => state.libraries[libraryKey]?.tagColors?.value ?? []);
	const { isGroup, isReadOnly } = useSelector(state => state.config.libraries.find(l => l.key === libraryKey));
	const pdfReaderURL = useSelector(state => state.config.pdfReaderURL);
	const isCreating = Object.keys(useSelector(state => state.libraries[libraryKey]?.creating?.items) ?? {}).length > 0;
	const isUpdating = Object.keys(useSelector(state => state.libraries[libraryKey]?.updating?.items) ?? {}).length > 0;
	const isBusy = isCreating || isUpdating;
	const wasBusy = usePrevious(isBusy);
	const lastFetchItemDetailsNoResults = useSelector(state => {
		const { libraryKey: requestLK, totalResults, queryOptions = {} } = state.traffic?.['FETCH_ITEM_DETAILS']?.last ?? {};
		return totalResults === 0 && requestLK === libraryKey && queryOptions.itemKey === attachmentKey;
	});
	const isReaderSidebarOpen = useSelector(state => state.preferences?.isReaderSidebarOpen);
	const readerSidebarWidth = useSelector(state => state.preferences?.readerSidebarWidth);
	const isFetchingUserLibrarySettings = useSelector(state => state.libraries[userLibraryKey]?.settings?.isFetching);
	const pdfWorker = useMemo(() => new PDFWorker({ pdfWorkerURL, pdfReaderCMapsRoot }), [pdfReaderCMapsRoot, pdfWorkerURL]);

	const [state, dispatchState] = useReducer(readerReducer, {
		action: null,
		isReady: false,
		data: null,
		dataState: UNFETCHED,
		annotationsState: NOT_IMPORTED,
		importedAnnotations: []
	});

	const [tagPicker, setTagPicker] = useState(null);
	const anchor = tagPicker ? pick(tagPicker, ['x', 'y']) : null;

	const { isFetching, isFetched, pointer, keys } = useFetchingState(
		['libraries', libraryKey, 'itemsByParent', attachmentKey]
	);
	const urlIsFresh = !!(url && (Date.now() - timestamp) < 60000);

	const annotations = (isFetched && keys ? keys : [])
		.map(childItemKey => allItems[childItemKey])
		.filter(item => !item.deleted && item.itemType === 'annotation');
	const prevAnnotations = usePrevious(annotations);

	const currentUser = useMemo(() => (
		{ id: currentUserID, username: currentUserSlug }
	), [currentUserID, currentUserSlug]);

	const handleClose = useCallback(() => {
		setTagPicker(null);
		iframeRef.current.focus();
	}, []);

	const getProcessedAnnotations = useCallback((annotations) => {
		const tagColorsMap = new Map(tagColors.map(
			({ name, color }, position) => ([name, { tag: name, color, position }]))
		);
		// @TODO: add mapping for Mendeley colors
		try {
			return annotations.map(annotation => {
				const { createdByUser, lastModifiedByUser } = annotation?.[Symbol.for('meta')] ?? {};
				return annotationItemToJSON(annotation, {
					attachmentItem, createdByUser, currentUser, isGroup, isReadOnly,
					lastModifiedByUser, libraryKey, tagColors: tagColorsMap
				});
			});
		} catch (e) {
			dispatch({
				type: ERROR_PROCESSING_ANNOTATIONS,
				error: "Failed to process annotations"
			});
			console.error(e);
		}
	}, [attachmentItem, currentUser, dispatch, isGroup, isReadOnly, libraryKey, tagColors]);

	const rotatePages = useCallback(async (oldBuf, pageIndexes, degrees) => {
		reader.current.freeze();
		const modifiedBuf = await pdfWorker.rotatePages(cloneData(oldBuf), pageIndexes, degrees, true);
		reader.current.reload({ buf: cloneData(modifiedBuf), baseURI: url });
		reader.current.unfreeze();
		dispatchState({ type: 'ROTATED_PAGES', data: cloneData(modifiedBuf) });
		try {
			const diff = await computeDiffUsingWorker(oldBuf, modifiedBuf);
			dispatch(patchAttachment(attachmentItem.key, modifiedBuf, diff));
		} catch(e) {
			dispatch(uploadAttachment(
				attachmentItem.key, { fileName: attachmentItem.filename, file: cloneData(modifiedBuf) })
			);
		}
	}, [attachmentItem, dispatch, pdfWorker, url]);

	const handleKeyDown = useCallback((ev) => {
		if (ev.key === 'Escape') {
			setTagPicker(null);
			iframeRef.current.focus();
		}
	}, []);

	// NOTE: handler can't be updated once it has been passed to Reader
	const handleChangeViewState = useDebouncedCallback(useCallback((newViewState, isPrimary) => {
		const pageIndexKey = PAGE_INDEX_KEY_LOOKUP[attachmentItem.contentType];
		if (isPrimary && userLibraryKey) {
			dispatch(updateLibrarySettings(pageIndexSettingKey, newViewState[pageIndexKey], userLibraryKey));
		}
	}, [attachmentItem, dispatch, pageIndexSettingKey, userLibraryKey]), 1000);

	// NOTE: handler can't be updated once it has been passed to Reader
	const handleToggleSidebar = useDebouncedCallback(useCallback((isOpen) => {
		dispatch(preferenceChange('isReaderSidebarOpen', isOpen));
	}, [dispatch]), 1000);

	// NOTE: handler can't be updated once it has been passed to Reader
	const handleResizeSidebar = useDebouncedCallback(useCallback((newWidth) => {
		dispatch(preferenceChange('readerSidebarWidth', newWidth));
	}, [dispatch]), 1000);

	const handleIframeLoaded = useCallback(() => {
		const processedAnnotations = getProcessedAnnotations(annotations);
		const pageIndexKey = PAGE_INDEX_KEY_LOOKUP[attachmentItem.contentType];
		const readerState = {
			fileName: attachmentItem.filename,
			[pageIndexKey]: locationValue
		};

		reader.current = iframeRef.current.contentWindow.createReader({
			type: READER_CONTENT_TYPES[attachmentItem.contentType],
			data: {
				buf: new Uint8Array(cloneData(state.data)),
				baseURI: new URL('/', window.location).toString()
			},
			annotations: [...processedAnnotations, ...state.importedAnnotations],
			primaryViewState: readerState,
			secondaryViewState: null,
			location: null,
			readOnly: isReadOnly,
			authorName: isGroup ? currentUserSlug : '',
			showItemPaneToggle: false,
			sidebarWidth: readerSidebarWidth,
			sidebarOpen: isReaderSidebarOpen ?? true,
			bottomPlaceholderHeight: 0,
			rtl: false,
			localizedStrings: strings,
			showAnnotations: true,
			onSaveAnnotations: (annotations) => {
				dispatch(postAnnotationsFromReader(annotations, attachmentKey));
			},
			onDeleteAnnotations: (annotationIds) => {
				dispatch(deleteItems(annotationIds));
			},
			onChangeViewState: handleChangeViewState,
			onOpenTagsPopup: (key, x, y) => {
				setTagPicker({ key, x, y});
				setTimeout(() => {
					document.querySelector('.add-tag').focus();
				}, 0);
			},
			onClosePopup: () => {
				// Note: This currently only closes tags popup when annotations are disappearing from pdf-reader sidebar.
				// Normal popup closing is handled by PopupPortal.
				setTagPicker(null);
			},
			onOpenLink: (url) => {
				window.open(url);
			},
			onToggleSidebar: handleToggleSidebar,
			onChangeSidebarWidth: handleResizeSidebar,
			onConfirm: (_title, text, _confirmationButtonTitle) => { // eslint-disable-line no-unused-vars
				return window.confirm(strings[text] ?? text);
			},
			onRotatePages: async (pageIndexes, degrees) => {
				dispatchState({ type: 'ROTATE_PAGES', pageIndexes, degrees });
			},
			onSetDataTransferAnnotations: noop, // n/a in web library, noop prevents errors printed on console from reader
			// onDeletePages: handleDeletePages
		});
	}, [annotations, attachmentItem, attachmentKey, currentUserSlug, dispatch, getProcessedAnnotations, handleChangeViewState, handleResizeSidebar, handleToggleSidebar, isGroup, isReadOnly, isReaderSidebarOpen, locationValue, readerSidebarWidth, state.data, state.importedAnnotations])

	// On first render, fetch attachment item details or redirect if invalid URL
	useEffect(() => {
		if(!attachmentKey) {
			dispatch(navigate({ items: null, attachmentKey: null, noteKey: null, view: 'item-list' }));
		}
		if (attachmentKey && !attachmentItem) {
			dispatch(fetchItemDetails(attachmentKey));
		}
		// pdf js stores last page in localStorage but we want to use one from user library settings instead
		localStorage.removeItem('pdfjs.history');
		// we also need user library settings for last page read syncing
		dispatch(fetchLibrarySettings(userLibraryKey, pageIndexSettingKey));
	}, []);// eslint-disable-line react-hooks/exhaustive-deps

	// Fetch all child items (annotations). This effect will execute multiple times for each page of annotations
	useEffect(() => {
		if (!isFetching && !isFetched) {
			const start = pointer || 0;
			const limit = PAGE_SIZE;
			dispatch(fetchChildItems(attachmentKey, { start, limit }));
		}
	}, [dispatch, attachmentKey, isFetching, isFetched, pointer]);

	// Fetch attachment URL
	useEffect(() => {
		if (!urlIsFresh && !isFetchingUrl) {
			dispatch(tryGetAttachmentURL(attachmentKey));
		}
	}, [attachmentKey, attachmentItem, dispatch, isFetchingUrl, prevAttachmentItem, urlIsFresh]);

	// Fetch attachment binary data
	useEffect(() => {
		if (urlIsFresh && state.dataState === UNFETCHED) {
			(async () => {
				dispatchState({ type: 'BEGIN_FETCH_DATA' });
				try {
					const data = await (await fetch(url)).arrayBuffer();
					dispatchState({ type: 'COMPLETE_FETCH_DATA', data });
				} catch (e) {
					dispatchState({ type: 'ERROR_FETCH_DATA', error: e });
				}
			})();
		}
	}, [state.dataState, url, urlIsFresh]);

	// import external annotations
	useEffect(() => {
		if (attachmentItem && state.dataState === FETCHED && state.annotationsState === NOT_IMPORTED) {
			(async () => {
				dispatchState({ type: 'BEGIN_IMPORT_ANNOTATIONS' });
				if (attachmentItem.contentType !== 'application/pdf') {
					dispatchState({ type: 'SKIP_IMPORT_ANNOTATIONS' });
					return;
				}
				try {
					// need to clone data before sending to worker, otherwise it will become detached
					const clonedData = cloneData(state.data);
					const importedAnnotations = (await pdfWorker.import(clonedData)).map(
						ia => annotationItemToJSON(ia, { attachmentItem })
					);
					dispatchState({ type: 'COMPLETE_IMPORT_ANNOTATIONS', importedAnnotations });
				} catch (e) {
					dispatchState({ type: 'ERROR_IMPORT_ANNOTATIONS', error: e });
				}
			})();
		}
	}, [attachmentItem, pdfWorker, state.annotationsState, state.data, state.dataState]);

	useEffect(() => {
		if (!state.isReady && isFetched && state.data && state.annotationsState == IMPORTED && !isFetchingUserLibrarySettings) {
			dispatchState({ type: 'READY' });
		}
	}, [isFetched, isFetchingUserLibrarySettings, state.annotationsState, state.data, state.isReady]);

	useEffect(() => {
		if (attachmentItem && !prevAttachmentItem
			&& (attachmentItem.itemType !== 'attachment' || !Object.keys(READER_CONTENT_TYPES).includes(attachmentItem.contentType))
		) {
			dispatch(navigate({ view: 'item-details' }));
		}
	}, [dispatch, attachmentItem, prevAttachmentItem]);

	useEffect(() => {
		if (lastFetchItemDetailsNoResults) {
			dispatch(navigate({ items: null, attachmentKey: null, noteKey: null, view: 'item-list' }));
		}
	}, [dispatch, lastFetchItemDetailsNoResults]);

	useEffect(() => {
		if (state.isReady && (!deepEqual(prevAnnotations, annotations) || (wasBusy && !isBusy))) {
			if (isBusy) {
				return;
			}
			const changedAnnotations = annotations.filter(a => {
				return !deepEqual(a, prevAnnotations.find(pa => pa.key === a.key))
			});
			reader.current.setAnnotations(getProcessedAnnotations(changedAnnotations));
		}
	}, [annotations, getProcessedAnnotations, isBusy, prevAnnotations, state.importedAnnotations, state.isReady, wasBusy]);

	useEffect(() => {
		if (state.isReady && state.action?.type === 'ROTATE_PAGES') {
			dispatchState({ type: 'ROTATING_PAGES' });
			rotatePages(state.data, state.action.pageIndexes, state.action.degrees);
		}
	}, [rotatePages, state.action, state.data, state.isReady]);

	return (
		<section className="reader-wrapper" onKeyDown={handleKeyDown} tabIndex="0">
			{state.isReady ? (
				<>
					<iframe onLoad={handleIframeLoaded} ref={iframeRef} src={pdfReaderURL} />
					{ tagPicker && (
						<PopupPortal anchor={ anchor } onClose={ handleClose }>
							{ tagPicker && <TagPicker itemKey={ tagPicker.key } libraryKey={ libraryKey } /> }
						</PopupPortal>
					) }
				</>
			) : (
				<div className="spinner-wrapper">
					<Spinner />
				</div>
			)
			}
		</section>
	);
}

export default memo(Reader);
