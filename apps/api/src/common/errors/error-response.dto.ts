import { ApiProperty } from '@nestjs/swagger';

/** Formato uniforme de error de la API (CLAUDE.md §10). */
export class ErrorResponseDto {
  @ApiProperty({ example: 'VALIDATION_ERROR', description: 'Código estable, en inglés.' })
  code!: string;

  @ApiProperty({
    example: 'Los datos enviados no son válidos.',
    description: 'Mensaje en español.',
  })
  message!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [],
  })
  details!: unknown[];

  @ApiProperty({ example: '0f8fad5b-d9cb-469f-a165-70867728950e' })
  requestId!: string;
}
