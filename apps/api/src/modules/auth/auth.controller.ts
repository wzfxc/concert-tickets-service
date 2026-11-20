import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { config } from '../../common/config.js';
import { clientIp, RateLimitService } from '../../common/rate-limit.js';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { LoginSchema, RegisterSchema } from '@tickets/shared';
import { hashPassword, verifyPassword } from '@tickets/shared/password';
import { AuthDto, UserDto } from '../../common/dto.js';
import { AppError } from '@tickets/domain';
import { PrismaService } from '../../common/infra.js';
import { signJwt, type AuthUser } from '../../common/jwt.js';
import { CurrentUser, Route, ZBody, type AppRequest } from '../../common/route.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  locale: 'uk' | 'en' | 'pl';
  password_hash: string;
}

const toUser = (u: UserRow): z.infer<typeof UserDto> => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  locale: u.locale,
});

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(32);

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimitService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @Route({
    summary: 'Log in (seeded or registered account)',
    public: true,
    body: LoginSchema,
    response: AuthDto,
  })
  async login(
    @ZBody() body: z.infer<typeof LoginSchema>,
    @Req() req: AppRequest,
  ): Promise<z.infer<typeof AuthDto>> {
    // Brute-force guard runs before any password hashing / token issuance.
    const emailKey = `email:${body.email.toLowerCase()}`;
    const ipKey = `ip:${clientIp(req)}`;
    const locked = Math.max(
      await this.limiter.lockedFor(emailKey),
      await this.limiter.lockedFor(ipKey),
    );
    if (locked > 0) {
      throw new AppError('RATE_LIMITED', 'Too many failed logins, try again later', {
        retryAfterSec: locked,
      });
    }
    const rows = await this.prisma.db.$queryRaw<UserRow[]>`
      SELECT id, email, name, role::text AS role, locale, password_hash FROM users WHERE lower(email) = lower(${body.email})`;
    const user = rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      await this.limiter.recordFailure(emailKey, config.bfEmailThreshold);
      await this.limiter.recordFailure(ipKey, config.bfIpThreshold);
      throw new AppError('UNAUTHORIZED', 'Invalid email or password');
    }
    await this.limiter.reset(emailKey);
    return { token: signJwt({ id: user.id, role: user.role }), user: toUser(user) };
  }

  @Post('auth/register')
  @Route({
    summary: 'Register a buyer account',
    public: true,
    body: RegisterSchema,
    response: AuthDto,
    status: 201,
  })
  async register(@ZBody() body: z.infer<typeof RegisterSchema>): Promise<z.infer<typeof AuthDto>> {
    const hash = await hashPassword(body.password);
    const rows = await this.prisma.db.$queryRaw<UserRow[]>`
      INSERT INTO users (email, password_hash, name, role, locale)
      VALUES (${body.email}, ${hash}, ${body.name}, 'buyer', ${body.locale})
      ON CONFLICT (lower(email)) DO NOTHING
      RETURNING id, email, name, role::text AS role, locale, password_hash`;
    const user = rows[0];
    if (!user) throw new AppError('CONFLICT', 'An account with this email already exists');
    return { token: signJwt({ id: user.id, role: user.role }), user: toUser(user) };
  }

  @Get('me')
  @Route({ summary: 'Current user', response: UserDto })
  async me(@CurrentUser() auth: AuthUser): Promise<z.infer<typeof UserDto>> {
    const rows = await this.prisma.db.$queryRaw<UserRow[]>`
      SELECT id, email, name, role::text AS role, locale, password_hash FROM users WHERE id = ${auth.id}::uuid`;
    if (!rows[0]) throw new AppError('UNAUTHORIZED', 'Account no longer exists');
    return toUser(rows[0]);
  }
}
