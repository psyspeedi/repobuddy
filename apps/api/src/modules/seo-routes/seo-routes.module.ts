import { Module } from '@nestjs/common'
import { SeoRoutesController } from './seo-routes.controller'

@Module({
  controllers: [SeoRoutesController],
})
export class SeoRoutesModule {}
