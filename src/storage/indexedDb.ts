
const DB_NAME = 'FileTransferDB';
const STORE_NAME = 'chunks';

let db: IDBDatabase | null = null;

export const initDB = (): Promise<void> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: ['fileName', 'chunkIndex'] });
            }
        };
        request.onsuccess = (e) => {
            db = (e.target as IDBOpenDBRequest).result;
            resolve();
        };
        request.onerror = (e) => reject(e);
    });
};

export const saveChunk = (fileName: string, chunkIndex: number, data: ArrayBuffer): Promise<void> => {
    if (!db) return Promise.reject('DB not initialized');
    return new Promise((resolve, reject) => {
        const tx = db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ fileName, chunkIndex, data });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

export const getAllChunks = (fileName: string): Promise<Blob[]> => {
    if (!db) return Promise.reject('DB not initialized');
    return new Promise((resolve, reject) => {
        const tx = db!.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        // const request = store.getAll(); // Removed unused getAll
        // Note: IndexedDB getAll orders by key. Our key is [fileName, chunkIndex].
        // So simple getAll filters needs IDBKeyRange.

        // Proper range query for just this file
        const range = IDBKeyRange.bound([fileName, 0], [fileName, Infinity]);
        const cursorRequest = store.openCursor(range);
        const chunks: Blob[] = [];

        cursorRequest.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest).result as IDBCursorWithValue;
            if (cursor) {
                chunks.push(new Blob([cursor.value.data]));
                cursor.continue();
            } else {
                resolve(chunks);
            }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
    });
};

export const deleteFileChunks = (fileName: string): Promise<void> => {
    if (!db) return Promise.reject('DB not initialized');
    return new Promise((resolve, reject) => {
        const tx = db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const range = IDBKeyRange.bound([fileName, 0], [fileName, Infinity]);
        // delete range
        const request = store.delete(range);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

// RAM Queue Logic (moved from app.js but kept together with storage)
export interface QueuedChunk {
    fileName: string;
    chunkIndex: number;
    data: ArrayBuffer;
}

export const RAM_QUEUE: QueuedChunk[] = [];
export let ramBytes = 0;
let diskWriterRunning = false;

export const pushToRamQueue = (chunk: QueuedChunk) => {
    RAM_QUEUE.push(chunk);
    ramBytes += chunk.data.byteLength;
    if (!diskWriterRunning) diskWriterLoop();
};

async function diskWriterLoop() {

    diskWriterRunning = true;

    while (RAM_QUEUE.length > 0) {
        // Optimization: Write batch? IDB transactions are cheaper in batch usually, 
        // but app.js did one by one in loop.
        // We stick to STRICT requirement: "Do NOT 'optimize' ... IndexedDB logic".
        // app.js logic:
        /*
        const chunk = RAM_QUEUE.shift();
        ramBytes -= chunk.data.byteLength;
        await saveChunkToIndexedDB(chunk);
        */
        const chunk = RAM_QUEUE.shift();
        if (chunk) {
            ramBytes -= chunk.data.byteLength;
            try {
                await saveChunk(chunk.fileName, chunk.chunkIndex, chunk.data);
            } catch (e) {

            }
        }
    }

    diskWriterRunning = false;

}
