import { Module } from '@nestjs/common';
import { ImageStorageModule } from '../images/image-storage.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [ImageStorageModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
