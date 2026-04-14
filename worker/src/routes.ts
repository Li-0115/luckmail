import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env} from './types';
import { 
  createMailbox, 
  getMailbox, 
  deleteMailbox, 
  getEmails, 
  getEmail, 
  deleteEmail,
  getAttachments,
  getAttachment
} from './database';
import { formatDateTime, generateId, generateRandomAddress } from './utils';

// 创建 Hono 应用
const app = new Hono<{ Bindings: Env }>();

function resolveConfiguredDomains(env: Env): string[] {
  const raw = String(env.VITE_EMAIL_DOMAIN || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((domain) => domain.trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean);
}

function buildMailboxAddress(name: string, requestedDomain: string, env: Env): string {
  const localPart = String(name || '').trim() || generateRandomAddress();
  const configuredDomains = resolveConfiguredDomains(env);
  const normalizedRequestedDomain = String(requestedDomain || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();

  const domain = normalizedRequestedDomain || configuredDomains[0] || '';
  if (!domain) {
    throw new Error('No mailbox domain configured');
  }
  return `${localPart}@${domain}`;
}

function toLegacyAdminMail(email: Awaited<ReturnType<typeof getEmail>>) {
  const receivedAt = email?.receivedAt || 0;
  const raw = [
    email?.subject ? `Subject: ${email.subject}` : '',
    email?.textContent || '',
    email?.htmlContent || '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    id: String(email?.id || ''),
    subject: String(email?.subject || ''),
    raw,
    created_at: formatDateTime(receivedAt).replace('T', ' ').replace('Z', ''),
    from: String(email?.fromAddress || ''),
    to: String(email?.toAddress || ''),
  };
}

// 添加 CORS 中间件
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

// 健康检查端点
app.get('/', (c) => {
  return c.json({ status: 'ok', message: '临时邮箱系统API正常运行' });
});

// 获取系统配置
app.get('/api/config', (c) => {
  try {
    const emailDomains = c.env.VITE_EMAIL_DOMAIN || '';
    const domains = emailDomains.split(',').map((domain: string) => domain.trim()).filter((domain: string) => domain);
    
    return c.json({ 
      success: true, 
      config: {
        emailDomains: domains
      }
    });
  } catch (error) {
    console.error('获取配置失败:', error);
    return c.json({ 
      success: false, 
      error: '获取配置失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 兼容旧版 CFWorker API：创建邮箱
app.post('/admin/new_address', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const address = buildMailboxAddress(
      String(body.name || ''),
      String(body.domain || ''),
      c.env,
    );
    const existingMailbox = await getMailbox(c.env.DB, address);

    if (existingMailbox) {
      return c.json({
        error: 'address_exists',
        message: '邮箱地址已存在',
      }, 409);
    }

    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const mailbox = await createMailbox(c.env.DB, {
      address,
      expiresInHours: 24,
      ipAddress: ip,
    });
    const token = generateId();

    return c.json({
      address: mailbox.address,
      email: mailbox.address,
      token,
      jwt: token,
      created_at: formatDateTime(mailbox.createdAt).replace('T', ' ').replace('Z', ''),
      expires_at: formatDateTime(mailbox.expiresAt).replace('T', ' ').replace('Z', ''),
    });
  } catch (error) {
    console.error('兼容接口 /admin/new_address 失败:', error);
    return c.json({
      error: 'create_address_failed',
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
});

// 兼容旧版 CFWorker API：拉取邮件列表
app.get('/admin/mails', async (c) => {
  try {
    const address = String(c.req.query('address') || '').trim();
    const limit = Math.max(Number(c.req.query('limit') || 20) || 20, 1);
    const offset = Math.max(Number(c.req.query('offset') || 0) || 0, 0);

    if (!address) {
      return c.json({
        error: 'missing_address',
        message: 'address is required',
      }, 400);
    }

    const mailbox = await getMailbox(c.env.DB, address);
    if (!mailbox) {
      return c.json({
        results: [],
        total: 0,
        limit,
        offset,
      });
    }

    const emails = await getEmails(c.env.DB, mailbox.id);
    const paged = emails.slice(offset, offset + limit);
    const results = [];

    for (const item of paged) {
      const detail = await getEmail(c.env.DB, item.id);
      if (!detail) continue;
      results.push(toLegacyAdminMail(detail));
    }

    return c.json({
      results,
      total: emails.length,
      limit,
      offset,
    });
  } catch (error) {
    console.error('兼容接口 /admin/mails 失败:', error);
    return c.json({
      error: 'list_mails_failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});


// 创建邮箱
app.post('/api/mailboxes', async (c) => {
  try {
    const body = await c.req.json();
    
    // 验证参数
    if (body.address && typeof body.address !== 'string') {
      return c.json({ success: false, error: '无效的邮箱地址' }, 400);
    }
    
    const expiresInHours = 24; // 固定24小时有效期
    
    // 获取客户端IP
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    
    // 生成或使用提供的地址
    const address = body.address || generateRandomAddress();
    
    // 检查邮箱是否已存在
    const existingMailbox = await getMailbox(c.env.DB, address);
    if (existingMailbox) {
      return c.json({ success: false, error: '邮箱地址已存在' }, 400);
    }
    
    // 创建邮箱
    const mailbox = await createMailbox(c.env.DB, {
      address,
      expiresInHours,
      ipAddress: ip,
    });
    
    return c.json({ success: true, mailbox });
  } catch (error) {
    console.error('创建邮箱失败:', error);
    return c.json({ 
      success: false, 
      error: '创建邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 400);
  }
});

// 获取邮箱信息
app.get('/api/mailboxes/:address', async (c) => {
  try {
    const address = c.req.param('address');
    const mailbox = await getMailbox(c.env.DB, address);
    
    if (!mailbox) {
      return c.json({ success: false, error: '邮箱不存在' }, 404);
    }
    
    return c.json({ success: true, mailbox });
  } catch (error) {
    console.error('获取邮箱失败:', error);
    return c.json({ 
      success: false, 
      error: '获取邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 删除邮箱
app.delete('/api/mailboxes/:address', async (c) => {
  try {
    const address = c.req.param('address');
    await deleteMailbox(c.env.DB, address);
    
    return c.json({ success: true });
  } catch (error) {
    console.error('删除邮箱失败:', error);
    return c.json({ 
      success: false, 
      error: '删除邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件列表
app.get('/api/mailboxes/:address/emails', async (c) => {
  try {
    const address = c.req.param('address');
    const mailbox = await getMailbox(c.env.DB, address);
    
    if (!mailbox) {
      return c.json({ success: false, error: '邮箱不存在' }, 404);
    }
    
    const emails = await getEmails(c.env.DB, mailbox.id);
    
    return c.json({ success: true, emails });
  } catch (error) {
    console.error('获取邮件列表失败:', error);
    return c.json({ 
      success: false, 
      error: '获取邮件列表失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件详情
app.get('/api/emails/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const email = await getEmail(c.env.DB, id);
    
    if (!email) {
      return c.json({ success: false, error: '邮件不存在' }, 404);
    }
    
    return c.json({ success: true, email });
  } catch (error) {
    console.error('获取邮件详情失败:', error);
    return c.json({ 
      success: false, 
      error: '获取邮件详情失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件的附件列表
app.get('/api/emails/:id/attachments', async (c) => {
  try {
    const id = c.req.param('id');
    
    // 检查邮件是否存在
    const email = await getEmail(c.env.DB, id);
    if (!email) {
      return c.json({ success: false, error: '邮件不存在' }, 404);
    }
    
    // 获取附件列表
    const attachments = await getAttachments(c.env.DB, id);
    
    return c.json({ success: true, attachments });
  } catch (error) {
    console.error('获取附件列表失败:', error);
    return c.json({ 
      success: false, 
      error: '获取附件列表失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取附件详情
app.get('/api/attachments/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const attachment = await getAttachment(c.env.DB, id);
    
    if (!attachment) {
      return c.json({ success: false, error: '附件不存在' }, 404);
    }
    
    // 检查是否需要直接返回附件内容
    const download = c.req.query('download') === 'true';
    
    if (download) {
      // 将Base64内容转换为二进制
      const binaryContent = atob(attachment.content);
      const bytes = new Uint8Array(binaryContent.length);
      for (let i = 0; i < binaryContent.length; i++) {
        bytes[i] = binaryContent.charCodeAt(i);
      }
      
      // 设置响应头
      c.header('Content-Type', attachment.mimeType);
      c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.filename)}"`);
      
      return c.body(bytes);
    }
    
    // 返回附件信息（不包含内容，避免响应过大）
    return c.json({ 
      success: true, 
      attachment: {
        id: attachment.id,
        emailId: attachment.emailId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: attachment.createdAt,
        isLarge: attachment.isLarge,
        chunksCount: attachment.chunksCount
      }
    });
  } catch (error) {
    console.error('获取附件详情失败:', error);
    return c.json({ 
      success: false, 
      error: '获取附件详情失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 删除邮件
app.delete('/api/emails/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteEmail(c.env.DB, id);
    
    return c.json({ success: true });
  } catch (error) {
    console.error('删除邮件失败:', error);
    return c.json({ 
      success: false, 
      error: '删除邮件失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

export default app;
