import {
    Controller,
    Get,
    NotFoundException,
    Res,
    StreamableFile,
} from '@nestjs/common';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import type { Response } from 'express';

@Controller('public/documents')
export class PublicDocumentsController {
    private resolveNomoRegistryPath(): string {
        const configured = process.env.NOMO_REGISTRY_PDF_PATH?.trim();
        if (configured && existsSync(configured)) return configured;
        return join(process.cwd(), 'assets', 'nomo-registry.pdf');
    }

    @Get('nomo-registry')
    getNomoRegistry(@Res({ passthrough: true }) res: Response): StreamableFile {
        const filePath = this.resolveNomoRegistryPath();
        if (!existsSync(filePath)) {
            throw new NotFoundException(
                'Registry verification document is not available yet.',
            );
        }

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline',
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
        });

        return new StreamableFile(createReadStream(filePath));
    }
}
