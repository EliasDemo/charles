import { ApiProperty } from '@nestjs/swagger';
import { BarbershopStatus, BarbershopType } from '../../../generated/prisma/enums';
import { RatingDto } from '../../barbershops/dto/barbershop.dto';

/** RF-FAV-003: barbería favorita (solo datos públicos). */
export class FavoriteDto {
  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: BarbershopType })
  type!: BarbershopType;

  @ApiProperty({ enum: [BarbershopStatus.OPEN, BarbershopStatus.TEMPORARILY_CLOSED] })
  status!: BarbershopStatus;

  @ApiProperty({ type: RatingDto })
  rating!: RatingDto;

  @ApiProperty({ format: 'date-time' })
  favoritedAt!: string;
}

export class FavoritePageDto {
  @ApiProperty({ type: [FavoriteDto] })
  items!: FavoriteDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
