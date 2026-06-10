import { Module } from '@nestjs/common';
import { PublicDocumentsController } from './public-documents.controller';

@Module({
    controllers: [PublicDocumentsController],
})
export class PublicDocumentsModule {}
