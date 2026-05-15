import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const VERIFICATION_FIELD_PHOTOS_BUCKET = 'verification-field-photos';

@Injectable()
export class UploadsService {
    private supabase: SupabaseClient;

    constructor(private configService: ConfigService) {
        const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
        const supabaseServiceRoleKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

        if (!supabaseUrl || !supabaseServiceRoleKey) {
            console.error('Environment Check Failed:');
            console.error(`SUPABASE_URL: ${supabaseUrl ? 'Set' : 'MISSING'}`);
            console.error(`SUPABASE_SERVICE_ROLE_KEY: ${supabaseServiceRoleKey ? 'Set' : 'MISSING'}`);
            // List all keys to verify if env is loaded at all (be careful not to log values)
            console.error('Available Env Keys:', Object.keys(process.env));

            throw new Error('Supabase URL or Service Role Key is missing. Check your Railway Project Variables.');
        }

        this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
            auth: {
                persistSession: false, // No session needed for backend
                autoRefreshToken: false,
            }
        });
    }

    async uploadFile(file: Express.Multer.File, pathPrefix: string, bucket: string = 'returns-disputes'): Promise<string> {
        if (!file) {
            throw new BadRequestException('No file provided');
        }

        const fileExt = file.originalname.split('.').pop();
        const fileName = `${pathPrefix}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;

        // Upload using Service Role (Bypasses RLS)
        const { data, error } = await this.supabase.storage
            .from(bucket)
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (error) {
            console.error('Supabase Upload Error:', error);
            throw new BadRequestException(`Upload failed: ${error.message}`);
        }

        // Get Public URL
        const { data: publicUrlData } = this.supabase.storage
            .from(bucket)
            .getPublicUrl(fileName);

        return publicUrlData.publicUrl;
    }

    /** Field verification officer photos — returns public URL and storage path for DB row. */
    async uploadVerificationFieldPhoto(
        file: Express.Multer.File,
        taskId: string,
    ): Promise<{ url: string; storagePath: string }> {
        if (!file?.buffer?.length) {
            throw new BadRequestException('No file provided');
        }

        let ext = (file.originalname?.split('.').pop() || 'jpg').toLowerCase();
        if (!/^(jpe?g|png|webp)$/.test(ext)) {
            ext = file.mimetype?.includes('png') ? 'png' : file.mimetype?.includes('webp') ? 'webp' : 'jpg';
        }

        const storagePath = `tasks/${taskId}/${Date.now()}_${Math.random().toString(36).substring(2, 10)}.${ext}`;

        const { error } = await this.supabase.storage
            .from(VERIFICATION_FIELD_PHOTOS_BUCKET)
            .upload(storagePath, file.buffer, {
                contentType: file.mimetype || `image/${ext}`,
                upsert: false,
            });

        if (error) {
            console.error('Supabase field photo upload:', error);
            throw new BadRequestException(`Upload failed: ${error.message}`);
        }

        const { data: urlData } = this.supabase.storage
            .from(VERIFICATION_FIELD_PHOTOS_BUCKET)
            .getPublicUrl(storagePath);

        return { url: urlData.publicUrl, storagePath };
    }
}
