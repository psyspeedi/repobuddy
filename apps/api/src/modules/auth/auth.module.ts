import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { AppConfigModule } from '../config/config.module'
import { AuthController } from './auth.controller'
import { AuthSerializer } from './auth.serializer'
import { AuthService } from './auth.service'
import { GithubStrategy } from './github.strategy'

@Module({
  imports: [
    AppConfigModule,
    PassportModule.register({ session: true, defaultStrategy: 'github' }),
  ],
  providers: [AuthService, GithubStrategy, AuthSerializer],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
