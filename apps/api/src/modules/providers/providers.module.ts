import { Global, Module } from '@nestjs/common'
import { AppConfigModule } from '../config/config.module'
import { ProviderResolverService } from './provider-resolver.service'

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [ProviderResolverService],
  exports: [ProviderResolverService],
})
export class ProvidersModule {}
