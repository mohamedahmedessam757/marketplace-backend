import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
    imports: [UploadsModule], // Import UploadsModule to use UploadsService
    controllers: [ReturnsController],
    providers: [ReturnsService],
})
export class ReturnsModule { }
