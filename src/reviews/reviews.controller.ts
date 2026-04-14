import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

// Note: In 2026 standards, you probably have a JwtAuthGuard and RolesGuard.
// I'm using generic annotations, assuming you have authentication configured.
// Adjust imports to match your actual AuthGuards.

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // Customer creates a new review
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Req() req, @Body() createReviewDto: CreateReviewDto) {
    // Assuming req.user is set by authentication middleware
    const customerId = req.user?.id || req.body.customerId; // Fallback for testing, in production rely strictly on JWT user ID
    
    if(!customerId) {
        throw new Error('User ID missing from Request');
    }
    
    return this.reviewsService.create(customerId, createReviewDto);
  }

  // Admin looks at all reviews
  @Get('admin')
  @UseGuards(JwtAuthGuard)
  findAllForAdmin() {
    return this.reviewsService.findAllForAdmin();
  }

  // Admin updates review status
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard)
  updateStatus(
    @Param('id') id: string,
    @Body() updateReviewStatusDto: UpdateReviewStatusDto,
  ) {
    return this.reviewsService.updateStatus(id, updateReviewStatusDto);
  }

  // Frontend generic fetch by store ID
  @Get('store/:storeId')
  findByStore(@Param('storeId') storeId: string) {
    return this.reviewsService.findByStore(storeId);
  }

  // Merchant fetches ALL their reviews
  @Get('merchant')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  findAllForMerchant(@Req() req) {
    return this.reviewsService.findAllForMerchant(req.user.id);
  }

  // Merchant fetches their review stats
  @Get('merchant/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.VENDOR)
  getMerchantStats(@Req() req) {
    return this.reviewsService.getMerchantStats(req.user.id);
  }
}
