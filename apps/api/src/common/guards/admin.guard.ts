import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../../modules/auth/auth.service'

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>()
    if (!req.isAuthenticated?.()) throw new UnauthorizedException()
    if (!this.auth.isAdmin(req.user?.login)) {
      throw new ForbiddenException('admin only')
    }
    return true
  }
}
