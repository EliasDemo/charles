import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, MaxLength } from 'class-validator';
import { BarbershopMemberRole } from '../../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InviteMemberDto {
  @ApiProperty({ example: 'socia@example.com', description: 'Correo de una cuenta existente.' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole' })
  @IsEnum(BarbershopMemberRole)
  role!: BarbershopMemberRole;
}

export class ChangeMemberRoleDto {
  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole' })
  @IsEnum(BarbershopMemberRole)
  role!: BarbershopMemberRole;
}

export class MemberDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole' })
  role!: BarbershopMemberRole;

  @ApiProperty()
  since!: Date;
}

export class MemberPageDto {
  @ApiProperty({ type: [MemberDto] })
  items!: MemberDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
