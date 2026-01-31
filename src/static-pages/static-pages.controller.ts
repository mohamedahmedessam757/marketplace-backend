import { Controller, Get, Param } from '@nestjs/common';
import { StaticPagesService } from './static-pages.service';

@Controller('static-pages')
export class StaticPagesController {
    constructor(private readonly staticPagesService: StaticPagesService) { }

    @Get()
    findAll() {
        return this.staticPagesService.findAll();
    }

    @Get(':slug')
    findOne(@Param('slug') slug: string) {
        return this.staticPagesService.findOne(slug);
    }
}
