import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StaticPagesService implements OnModuleInit {
    constructor(private prisma: PrismaService) { }

    async onModuleInit() {
        // Seed default pages if not exist
        const count = await this.prisma.staticPage.count();
        if (count === 0) {
            const pages = [
                { slug: 'about', titleAr: 'من نحن', titleEn: 'About Us', contentAr: 'محتوى تجريبي عن الشركة...', contentEn: 'Demo content about us...' },
                { slug: 'how-we-work', titleAr: 'كيف نعمل', titleEn: 'How We Work', contentAr: 'خطوات العمل...', contentEn: 'Work steps...' },
                { slug: 'terms', titleAr: 'الشروط والأحكام', titleEn: 'Terms & Conditions', contentAr: 'الشروط...', contentEn: 'Terms...' },
                { slug: 'privacy', titleAr: 'سياسة الخصوصية', titleEn: 'Privacy Policy', contentAr: 'السياسة...', contentEn: 'Policy...' },
                { slug: 'return-policy', titleAr: 'سياسة الإرجاع', titleEn: 'Return Policy', contentAr: 'سياسة الإرجاع...', contentEn: 'Return Policy...' },
                { slug: 'contact', titleAr: 'تواصل معنا', titleEn: 'Contact Us', contentAr: 'بيانات التواصل...', contentEn: 'Contact info...' },
            ];

            for (const page of pages) {
                await this.prisma.staticPage.create({ data: page });
            }
            console.log('Seeded Static Pages');
        }
    }

    async findAll() {
        return this.prisma.staticPage.findMany();
    }

    async findOne(slug: string) {
        return this.prisma.staticPage.findUnique({ where: { slug } });
    }
}
