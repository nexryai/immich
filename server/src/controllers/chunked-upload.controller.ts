import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type Request } from 'express';
import { type AuthDto } from 'src/dtos/auth.dto.js';
import { ChunkedUploadCreateDto, ChunkedUploadQueryDto } from 'src/dtos/chunked-upload.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { CHUNKED_UPLOAD_CHUNK_SIZE } from 'src/repositories/chunked-upload.repository.js';
import { ChunkedUploadService } from 'src/services/chunked-upload.service.js';
import { UUIDParamDto } from 'src/validation.js';

// Fork-private protocol: keep upstream SDKs and mobile clients unchanged.
@ApiExcludeController()
@Controller('uploads/chunked')
export class ChunkedUploadController {
  constructor(private service: ChunkedUploadService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  capabilities() {
    return { version: 1, chunkSize: CHUNKED_UPLOAD_CHUNK_SIZE };
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  create(@Auth() auth: AuthDto, @Body() dto: ChunkedUploadCreateDto) {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  get(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  write(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { offset }: ChunkedUploadQueryDto,
    @Req() request: Request,
  ) {
    if (!request.is('application/octet-stream')) {
      throw new UnsupportedMediaTypeException('Chunks must use application/octet-stream');
    }
    return this.service.write(auth, id, offset, request);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  complete(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.complete(auth, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  remove(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.remove(auth, id);
  }
}
