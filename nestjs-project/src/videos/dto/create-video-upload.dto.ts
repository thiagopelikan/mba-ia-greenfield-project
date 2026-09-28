import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreateVideoUploadDto {
  /** Original file name, used as the default title and download name. */
  @IsString()
  @Length(1, 255)
  file_name: string;

  /** File size in bytes (maximum 10 GiB, enforced by the service). */
  @IsInt()
  @Min(1)
  file_size: number;

  /** Declared MIME type; must be a `video/*` type. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/)
  mime_type: string;

  /** Optional title; defaults to the file name without extension. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
