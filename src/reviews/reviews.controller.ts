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

// Note: In 2026 standards, you probably have a JwtAuthGuard and RolesGuard.
// I'm using generic annotations, assuming you have authentication configured.
// Adjust imports to match your actual AuthGuards.

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // Customer creates a new review
  @Post()
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
  findAllForAdmin() {
    return this.reviewsService.findAllForAdmin();
  }

  // Admin updates review status
  @Patch(':id/status')
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
}
