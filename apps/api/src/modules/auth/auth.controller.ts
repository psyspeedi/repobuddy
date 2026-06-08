import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Request, Response } from 'express'
import { TypedConfigService } from '../config/typed-config.service'

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
  ) {}

  /** Start GitHub OAuth — passport-github2 redirects to GitHub. */
  @Get('github')
  @UseGuards(AuthGuard('github'))
  loginViaGithub(): void {
    // passport handles redirect
  }

  /** GitHub OAuth callback — passport hydrates req.user; we redirect to the SPA. */
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  callback(@Res() res: Response): void {
    res.redirect(`${this.config.get('APP_URL')}/`)
  }

  /** Frontend reads session via this endpoint on every navigation. */
  @Get('me')
  me(@Req() req: Request): { user: Express.User | null } {
    return { user: req.user ?? null }
  }

  /** Clear session + Passport login state. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.logout((err) => {
        if (err) return reject(err)
        req.session.destroy(() => {
          res.clearCookie('repobuddy-session')
          res.status(204).send()
          resolve()
        })
      })
    })
  }
}
