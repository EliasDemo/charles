import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { clientIpOf } from '../../common/throttling/client-ip-throttler.guard';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { AcceptedResponseDto } from '../auth/dto/auth.dto';
import { InviteBarberDto } from '../barbers/dto/barber.dto';
import { InviteMemberDto } from '../barbershops/dto/member.dto';
import { AcceptInvitationDto, InvitationPageDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

const uuid = new ParseUUIDPipe();

@ApiTags('invitations')
@ApiBearerAuth()
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @RateLimit('auth')
  @Post('barbershops/:id/members/invitations')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Invitar a una cuenta existente como responsable (solo OWNER; respuesta idéntica)',
  })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  inviteMember(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: InviteMemberDto,
  ): Promise<AcceptedResponseDto> {
    return this.invitations.inviteMember(user, id, dto.email, dto.role);
  }

  @RateLimit('auth')
  @Post('barbershops/:id/barbers/:barberId/invitations')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'RF-BRB-001: invitar a una cuenta a vincularse con un barbero' })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  inviteBarber(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: InviteBarberDto,
  ): Promise<AcceptedResponseDto> {
    return this.invitations.inviteBarber(user, id, barberId, dto.email);
  }

  @Get('me/barbershop-invitations')
  @ApiOperation({ summary: 'Mis invitaciones pendientes' })
  @ApiOkResponse({ type: InvitationPageDto })
  listMine(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<InvitationPageDto> {
    return this.invitations.listMine(user, query);
  }

  @RateLimit('auth')
  @Post('me/barbershop-invitations/:invitationId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Aceptar una invitación con su código' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('invitationId', uuid) invitationId: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.invitations.accept(user, invitationId, dto.code, {
      ip: clientIpOf(req),
      userAgent: req.headers['user-agent'],
    });
  }
}
