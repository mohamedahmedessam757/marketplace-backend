import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
    @Get()
    getRoot() {
        return { status: 'ok', message: 'E-Tashleh API is running' };
    }

    @Get('health')
    healthCheck() {
        return { status: 'healthy', timestamp: new Date().toISOString() };
    }
}
