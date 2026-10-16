-- Telegram como destino das ofertas (canal ou grupo), enviado por um bot do próprio usuário (2026-10-16).
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'TELEGRAM';
