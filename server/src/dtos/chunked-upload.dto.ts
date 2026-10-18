import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetVisibilitySchema } from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

export class ChunkedUploadCreateDto extends createZodDto(
  z.object({
    filename: z.string().min(1).max(255),
    fileCreatedAt: isoDatetimeToDate,
    fileModifiedAt: isoDatetimeToDate,
    isFavorite: z.boolean().optional(),
    visibility: AssetVisibilitySchema.optional(),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z
      .string()
      .regex(/^[\da-f]{40}$/i)
      .optional(),
  }),
) {}

export class ChunkedUploadQueryDto extends createZodDto(
  z.object({ offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
) {}
