import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class UploadsService {
    private supabase: SupabaseClient;

    constructor(private configService: ConfigService) {
        const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
        const supabaseServiceRoleKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

        if (!supabaseUrl || !supabaseServiceRoleKey) {
            throw new Error('Supabase URL or Service Role Key is missing');
        }

        this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
            auth: {
                persistSession: false, // No session needed for backend
                autoRefreshToken: false,
            }
        });
    }

    async uploadFile(file: Express.Multer.File, pathPrefix: string): Promise<string> {
        if (!file) {
            throw new BadRequestException('No file provided');
        }

        const fileExt = file.originalname.split('.').pop();
        const fileName = `${pathPrefix}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;

        // Upload using Service Role (Bypasses RLS)
        const { data, error } = await this.supabase.storage
            .from('returns-disputes')
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
            .from('returns-disputes')
            .getPublicUrl(fileName);

        return publicUrlData.publicUrl;
    }
}
