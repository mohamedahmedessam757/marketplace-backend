import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { CreateRatingImpactRuleDto, UpdateRatingImpactRuleDto } from './dto/rating-impact-rule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // Customer creates a new review
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Req() req, @Body() createReviewDto: CreateReviewDto) {
    const customerId = req.user?.id;
    if(!customerId) throw new Error('User ID missing from Request');
    return this.reviewsService.create(customerId, createReviewDto);
  }

  // Admin looks at all reviews
  @Get('admin')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'view')
  findAllForAdmin() {
    return this.reviewsService.findAllForAdmin();
  }

  // Admin updates review status
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'edit')
  updateStatus(
    @Req() req,
    @Param('id') id: string,
    @Body() updateReviewStatusDto: UpdateReviewStatusDto,
  ) {
    return this.reviewsService.updateStatus(req.user.id, id, updateReviewStatusDto);
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

  // --- RATING IMPACT RULES (ADMIN) ---

  @Get('admin/impact-rules')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'view')
  getRatingImpactRules() {
    return this.reviewsService.getRatingImpactRules();
  }

  @Post('admin/impact-rules')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'edit')
  createRatingImpactRule(@Body() dto: CreateRatingImpactRuleDto) {
    return this.reviewsService.createRatingImpactRule(dto);
  }

  @Patch('admin/impact-rules/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'edit')
  updateRatingImpactRule(
    @Param('id') id: string,
    @Body() dto: UpdateRatingImpactRuleDto,
  ) {
    return this.reviewsService.updateRatingImpactRule(id, dto);
  }

  @Delete('admin/impact-rules/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('reviews', 'edit')
  deleteRatingImpactRule(@Param('id') id: string) {
    return this.reviewsService.deleteRatingImpactRule(id);
  }
}
