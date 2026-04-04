import { useEffect, useRef, useState } from 'react';

export function useTimelineFollow(latestTimelineKey: string, selectedSessionId: string) {
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const [followTimelineTail, setFollowTimelineTail] = useState(true);

  useEffect(() => {
    setFollowTimelineTail(true);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!followTimelineTail) {
      return;
    }

    const timelineContainer = timelineContainerRef.current;
    if (!timelineContainer) {
      return;
    }

    timelineContainer.scrollTop = timelineContainer.scrollHeight;
  }, [followTimelineTail, latestTimelineKey, selectedSessionId]);

  const handleTimelineScroll = () => {
    const timelineContainer = timelineContainerRef.current;
    if (!timelineContainer) {
      return;
    }

    const distanceFromBottom = timelineContainer.scrollHeight - timelineContainer.scrollTop - timelineContainer.clientHeight;
    setFollowTimelineTail(distanceFromBottom <= 36);
  };

  const jumpToLatest = () => {
    const timelineContainer = timelineContainerRef.current;
    if (timelineContainer) {
      timelineContainer.scrollTop = timelineContainer.scrollHeight;
    }
    setFollowTimelineTail(true);
  };

  return {
    timelineContainerRef,
    followTimelineTail,
    setFollowTimelineTail,
    handleTimelineScroll,
    jumpToLatest,
  };
}