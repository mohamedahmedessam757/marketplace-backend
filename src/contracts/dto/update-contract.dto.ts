import { IsNotEmpty, IsString, IsOptional, IsObject } from 'class-validator';

export class UpdateContractDto {
  @IsString({ message: 'Arabic content must be a string' })
  @IsNotEmpty({ message: 'Arabic content is required' })
  contentAr: string;

  @IsString({ message: 'English content must be a string' })
  @IsNotEmpty({ message: 'English content is required' })
  contentEn: string;

  @IsObject()
  @IsOptional()
  firstPartyConfig?: Record<string, any>;
}
