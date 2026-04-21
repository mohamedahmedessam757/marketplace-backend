
import { Controller, Post, Body } from '@nestjs/common';
import { ChatService } from './chat.service';

/**
 * PublicChatController (2026 Strategy)
 * Handles support requests from the Landing Page that do NOT require authentication.
 */
@Controller('public-support')
export class PublicChatController {
    constructor(private readonly chatService: ChatService) { }

    @Post()
    async submitPublicSupport(
        @Body() body: { 
            name: string; 
            email: string; 
            phone: string; 
            subject: string; 
            message: string; 
            userId?: string 
        }
    ) {
        return this.chatService.createPublicSupportChat(body);
    }
}
