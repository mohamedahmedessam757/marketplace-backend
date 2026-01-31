import { IsEnum, IsNotEmpty, IsUrl } from 'class-validator';
import { DocType } from '@prisma/client';

export class UploadStoreDocumentDto {
    @IsEnum(DocType)
    docType: DocType;

    @IsUrl({}, { message: 'fileUrl must be a valid URL (e.g. Supabase Storage public link)' })
    @IsNotEmpty()
    fileUrl: string;
}
