import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';

@Injectable()
export class SupportService {
    constructor(private prisma: PrismaService) { }

    async create(userId: string, createTicketDto: CreateTicketDto) {
        console.log('SupportService.create called with userId:', userId);
        const ticketNumber = `TKT-${Date.now()}`; // Simple generation for now

        return this.prisma.supportTicket.create({
            data: {
                ticketNumber,
                subject: createTicketDto.subject,
                message: createTicketDto.message, // Initial message content (also stored as first message)
                priority: createTicketDto.priority,
                userId: userId,
                userType: 'CUSTOMER', // Explicitly set needed if schema default isn't picking up or if type definition is stale
                messages: {
                    create: {
                        text: createTicketDto.message,
                        senderId: userId,
                        senderRole: 'user',
                        mediaUrl: createTicketDto.mediaUrl,
                        mediaType: createTicketDto.mediaType
                    }
                }
            },
            include: {
                messages: true
            }
        });
    }

    async findAll(userId: string, role: string) {
        // If admin, show all? Or just support role? For now let's assume User sees their own.
        const whereClause = role === 'CUSTOMER' || role === 'VENDOR' ? { userId } : {};

        return this.prisma.supportTicket.findMany({
            where: whereClause,
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findOne(id: string) {
        const ticket = await this.prisma.supportTicket.findUnique({
            where: { id },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });
        if (!ticket) throw new NotFoundException('Ticket not found');
        return ticket;
    }

    async addMessage(ticketId: string, senderId: string, role: string, text: string, mediaUrl?: string, mediaType?: string) {
        const ticket = await this.findOne(ticketId);

        // Update ticket status if user replies -> OPEN
        if (role === 'CUSTOMER' && ticket.status === 'RESOLVED') {
            await this.prisma.supportTicket.update({
                where: { id: ticketId },
                data: { status: 'OPEN', updatedAt: new Date() }
            });
        } else {
            await this.prisma.supportTicket.update({
                where: { id: ticketId },
                data: { updatedAt: new Date() }
            });
        }

        return this.prisma.ticketMessage.create({
            data: {
                ticketId,
                senderId,
                senderRole: role === 'CUSTOMER' ? 'user' : 'support',
                text,
                mediaUrl,
                mediaType
            }
        });
    }
}
