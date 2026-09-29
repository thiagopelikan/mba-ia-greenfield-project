import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Part number returned by the upload plan (1–10000). */
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  /** ETag header returned by the storage for this part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteVideoUploadDto {
  /** Every uploaded part with its ETag. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
