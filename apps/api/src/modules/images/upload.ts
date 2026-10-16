import { UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { MAX_UPLOAD_BYTES } from './image-processing';

/** Lo único que se usa del archivo que entrega multer: el contenido en memoria. */
export interface UploadedImage {
  buffer: Buffer;
}

/** Un solo archivo, en memoria (sin `dest` multer nunca escribe a disco), con el tope de la API. */
export const SingleFile = (): MethodDecorator =>
  UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 },
    }),
  );

/** Documentación común de las subidas. */
export const UploadDocs = (body: new () => unknown): MethodDecorator => {
  return (target, key, descriptor) => {
    ApiConsumes('multipart/form-data')(target, key, descriptor);
    ApiBody({ type: body })(target, key, descriptor);
    ApiBadRequestResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiPayloadTooLargeResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiTooManyRequestsResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiServiceUnavailableResponse({ type: ErrorResponseDto })(target, key, descriptor);
  };
};

export const UPLOAD_NOTE =
  'multipart/form-data, campo `file`: JPEG, PNG o WebP hasta 10 MB (HEIC: convertir en la app). ' +
  'Se eliminan los metadatos (EXIF y GPS) y se guarda en WebP.';
