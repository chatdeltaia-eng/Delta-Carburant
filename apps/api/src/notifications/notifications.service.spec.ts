import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const query = jest.fn();
  const service = new NotificationsService({ query } as never);

  beforeEach(() => query.mockReset());

  it('limite toujours la liste à la session authentifiée', async () => {
    query.mockResolvedValue([]);
    await service.list('najib-user-id');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id=$1'), ['najib-user-id']);
  });

  it('marque uniquement les notifications du propriétaire comme lues', async () => {
    query.mockResolvedValue([{ id: 'notification-1' }]);
    await expect(service.readAll('najib-user-id')).resolves.toEqual({ updated: 1, read: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id=$1 AND read_at IS NULL'), ['najib-user-id']);
  });

  it('marque uniquement les notifications du propriétaire comme non lues', async () => {
    query.mockResolvedValue([{ id: 'notification-1' }, { id: 'notification-2' }]);
    await expect(service.unreadAll('zin-user-id')).resolves.toEqual({ updated: 2, read: false });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id=$1 AND read_at IS NOT NULL'), ['zin-user-id']);
  });

  it('interdit de modifier une notification appartenant à un autre utilisateur', async () => {
    query.mockResolvedValue([]);
    await expect(service.read('notification-id', 'najib-user-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND user_id=$2'), ['notification-id', 'najib-user-id']);
  });
});
