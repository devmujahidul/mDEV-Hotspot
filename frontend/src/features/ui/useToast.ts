import { useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { toastAdded, Toast as ToastType } from './uiSlice';

export function useToast() {
  const dispatch = useAppDispatch();
  return useCallback(
    (kind: ToastType['kind'], message: string, ttl = 5000) => {
      dispatch(toastAdded({ kind, message, ttl }));
    },
    [dispatch]
  );
}
