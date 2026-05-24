import { memoryStorage } from 'multer';

/** In-memory multer — required for Supabase uploads via file.buffer */
export const multerMemoryOptions = {
    storage: memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
};

export const multerMemoryOptions10Mb = {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
};
