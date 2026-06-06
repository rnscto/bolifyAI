import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, RotateCcw, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

export default function AudioPlayer({ url }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration);
    const onEnd = () => setPlaying(false);
    const onErr = () => setError(true);

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);

    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onErr);
    };
  }, [url]);

  const togglePlay = () => {
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  const seek = (val) => {
    audioRef.current.currentTime = val[0];
    setCurrentTime(val[0]);
  };

  const restart = () => {
    audioRef.current.currentTime = 0;
    setCurrentTime(0);
    audioRef.current.play();
    setPlaying(true);
  };

  const fmt = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">
        <VolumeX className="w-3.5 h-3.5" />
        Recording unavailable
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
      <audio ref={audioRef} src={url} preload="metadata" />
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={togglePlay}>
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </Button>
      <span className="text-xs text-gray-500 w-9 text-right">{fmt(currentTime)}</span>
      <div className="flex-1 min-w-[80px]">
        <Slider
          value={[currentTime]}
          min={0}
          max={duration || 1}
          step={0.5}
          onValueChange={seek}
          className="cursor-pointer"
        />
      </div>
      <span className="text-xs text-gray-500 w-9">{fmt(duration)}</span>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setMuted(!muted)}>
        {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
      </Button>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={restart}>
        <RotateCcw className="w-3.5 h-3.5" />
      </Button>
      <a
        href={url}
        download
        target="_blank"
        rel="noopener noreferrer"
        title="Download recording"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent hover:text-accent-foreground"
      >
        <Download className="w-3.5 h-3.5" />
      </a>
      {muted && audioRef.current && (audioRef.current.muted = true)}
      {!muted && audioRef.current && (audioRef.current.muted = false)}
    </div>
  );
}