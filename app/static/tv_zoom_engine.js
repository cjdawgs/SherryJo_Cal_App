const STORAGE_KEYS = Object.freeze({
    current: 'tv_zoom_level',
    default: 'tv_default_zoom_level',
});

export const SUPPORTED_ZOOM_LEVELS = Object.freeze([100, 110, 125, 150, 175, 200]);

function normalizeZoomLevel(value) {
    const numeric = Number(value);
    return SUPPORTED_ZOOM_LEVELS.includes(numeric) ? numeric : 100;
}

function levelToScale(level) {
    return normalizeZoomLevel(level) / 100;
}

function safeStorageGet(storage, key) {
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

function safeStorageSet(storage, key, value) {
    try {
        storage.setItem(key, value);
    } catch {
        return false;
    }
    return true;
}

export function createTvZoomEngine({
    root = document.documentElement,
    storage = window.localStorage,
} = {}) {
    let currentZoomLevel = 100;
    let defaultZoomLevel = 100;

    function applyCssScale() {
        root.style.setProperty('--tv-scale', String(levelToScale(currentZoomLevel).toFixed(2)));
    }

    function persistCurrent() {
        safeStorageSet(storage, STORAGE_KEYS.current, String(currentZoomLevel));
    }

    function persistDefault() {
        safeStorageSet(storage, STORAGE_KEYS.default, String(defaultZoomLevel));
    }

    function restore() {
        const storedCurrent = normalizeZoomLevel(safeStorageGet(storage, STORAGE_KEYS.current));
        const storedDefault = normalizeZoomLevel(safeStorageGet(storage, STORAGE_KEYS.default));

        currentZoomLevel = storedCurrent;
        defaultZoomLevel = storedDefault;
        applyCssScale();
        persistCurrent();
        persistDefault();

        return {
            currentZoomLevel,
            defaultZoomLevel,
            scale: levelToScale(currentZoomLevel),
        };
    }

    function setZoomLevel(nextLevel, options = {}) {
        const normalized = normalizeZoomLevel(nextLevel);
        if (normalized === currentZoomLevel) {
            if (options.persist !== false) persistCurrent();
            return false;
        }

        currentZoomLevel = normalized;
        applyCssScale();
        if (options.persist !== false) persistCurrent();
        return true;
    }

    function zoomIn() {
        const index = SUPPORTED_ZOOM_LEVELS.indexOf(currentZoomLevel);
        if (index < 0 || index >= SUPPORTED_ZOOM_LEVELS.length - 1) return false;
        return setZoomLevel(SUPPORTED_ZOOM_LEVELS[index + 1]);
    }

    function zoomOut() {
        const index = SUPPORTED_ZOOM_LEVELS.indexOf(currentZoomLevel);
        if (index <= 0) return false;
        return setZoomLevel(SUPPORTED_ZOOM_LEVELS[index - 1]);
    }

    function resetZoom() {
        return setZoomLevel(100);
    }

    function saveDefaultZoomLevel() {
        const normalized = normalizeZoomLevel(currentZoomLevel);
        if (normalized === defaultZoomLevel) {
            persistDefault();
            return false;
        }
        defaultZoomLevel = normalized;
        persistDefault();
        return true;
    }

    function applyHomeZoomPreference() {
        return setZoomLevel(defaultZoomLevel);
    }

    function getZoomLevel() {
        return currentZoomLevel;
    }

    function getDefaultZoomLevel() {
        return defaultZoomLevel;
    }

    return {
        restore,
        setZoomLevel,
        zoomIn,
        zoomOut,
        resetZoom,
        saveDefaultZoomLevel,
        applyHomeZoomPreference,
        getZoomLevel,
        getDefaultZoomLevel,
    };
}