import { Global, Module } from '@nestjs/common';
import { EmailConfig } from './email.config';
import { EmailChannelService } from './email-channel.service';

@Global()
@Module({
    providers: [EmailConfig, EmailChannelService],
    exports: [EmailConfig, EmailChannelService],
})
export class EmailModule {}
