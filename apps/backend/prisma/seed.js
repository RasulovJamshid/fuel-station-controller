// @ts-nocheck
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
    const email    = process.env.SEED_ADMIN_EMAIL    ?? 'admin@ung.uz';
    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!password) {
        console.error('SEED_ADMIN_PASSWORD is not set in .env');
        process.exit(1);
    }

    const slug = 'ung';
    let company = await prisma.company.findUnique({ where: { slug } });
    if (!company) {
        company = await prisma.company.create({ data: { name: 'UNG Fuel', slug } });
        console.log(`Created company: ${company.name}`);
    }

    const existing = await prisma.user.findFirst({
        where: { email, companyId: company.id },
    });

    if (!existing) {
        const hash = await bcrypt.hash(password, 12);
        await prisma.user.create({
            data: {
                companyId:         company.id,
                email,
                name:              'Super Admin',
                passwordHash:      hash,
                role:              'SUPER_ADMIN',
                passwordChangedAt: new Date(),
            },
        });
        console.log(`Created superadmin: ${email}`);
    } else {
        console.log(`Superadmin already exists: ${email}`);
    }
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
