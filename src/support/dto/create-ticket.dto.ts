import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';

export class CreateTicketDto {
    @IsString()
    @IsNotEmpty()
    subject: string;

    @IsString()
    @IsNotEmpty()
    message: string;

    @IsString()
    @IsEnum(['LOW', 'MEDIUM', 'HIGH'])
    priority: 'LOW' | 'MEDIUM' | 'HIGH';

    @IsString()
    @IsOptional()
    userId?: string; // For testing/manual override if needed

    @IsString()
    @IsOptional()
    mediaUrl?: string;

    @IsString()
    @IsOptional()
    mediaType?: string;
}
