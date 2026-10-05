import { ApiProperty } from '@nestjs/swagger';

export enum ComponentStatus {
  Up = 'up',
  Down = 'down',
}

export class HealthChecksDto {
  @ApiProperty({ enum: ComponentStatus, enumName: 'ComponentStatus' })
  database!: ComponentStatus;

  @ApiProperty({ enum: ComponentStatus, enumName: 'ComponentStatus' })
  redis!: ComponentStatus;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ type: HealthChecksDto })
  checks!: HealthChecksDto;
}
