import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { BarbershopMemberRole, InvitationKind } from '../../../generated/prisma/enums';

export class AcceptInvitationDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class InvitationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: InvitationKind, enumName: 'InvitationKind' })
  kind!: InvitationKind;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole', nullable: true })
  memberRole!: BarbershopMemberRole | null;

  @ApiProperty({ nullable: true, type: String, description: 'Perfil de barbero a vincular.' })
  barberDisplayName!: string | null;

  @ApiProperty()
  expiresAt!: Date;
}

export class InvitationPageDto {
  @ApiProperty({ type: [InvitationDto] })
  items!: InvitationDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
