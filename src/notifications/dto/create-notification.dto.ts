import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateNotificationDto {
    @IsUUID()
    @IsNotEmpty()
    recipientId: string;

    @IsString()
    @IsOptional()
    recipientRole?: string;

    @IsString()
    @IsNotEmpty()
    titleAr: string;

    @IsString()
    @IsNotEmpty()
    titleEn: string;

    @IsString()
    @IsNotEmpty()
    messageAr: string;

    @IsString()
    @IsNotEmpty()
    messageEn: string;

    @IsString()
    @IsOptional()
    type?: string;

    @IsString()
    @IsOptional()
    link?: string;

    @IsOptional()
    metadata?: any;
}
