import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shifts')
export class ShiftsController {
    constructor(private shifts: ShiftsService) {}

    @Get()
    findAll(
        @CurrentUser() user: any,
        @Query() pagination: PaginationDto,
        @Query('stationId') stationId?: string,
    ) {
        return this.shifts.findAll(user.companyId, stationId, pagination);
    }

    @Get('active')
    getActive(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        return this.shifts.getActive(user.companyId, stationId);
    }

    @Get(':id')
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.shifts.findOne(id, user.companyId);
    }
}
