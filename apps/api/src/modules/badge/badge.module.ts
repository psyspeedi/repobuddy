import { Module } from '@nestjs/common'
import { BadgeController } from './badge.controller'

@Module({
  controllers: [BadgeController],
})
export class BadgeModule {}
