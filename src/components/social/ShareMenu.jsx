import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Share2, Copy, Download, Check, MessageCircle, Linkedin, Facebook, Twitter } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";

export default function ShareMenu({ post, onShared }) {
  const [copied, setCopied] = useState(false);

  const fullText = `${post.caption}\n\n${post.hashtags}`;
  const encodedText = encodeURIComponent(fullText);
  const encodedCaption = encodeURIComponent(post.caption);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(fullText);
    setCopied(true);
    toast({ title: "Copied!", description: "Caption & hashtags copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
    onShared?.('clipboard');
  };

  const handleDownload = async () => {
    if (!post.poster_url) return;
    const link = document.createElement('a');
    link.href = post.poster_url;
    link.download = `${post.title || 'poster'}.png`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    onShared?.('download');
  };

  const shareLinks = [
    {
      name: 'WhatsApp',
      icon: MessageCircle,
      color: 'text-green-600',
      url: `https://wa.me/?text=${encodedText}${post.poster_url ? '%0A%0A' + encodeURIComponent(post.poster_url) : ''}`
    },
    {
      name: 'LinkedIn',
      icon: Linkedin,
      color: 'text-blue-700',
      url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(post.poster_url || 'https://vaaniai.io')}&summary=${encodedCaption}`
    },
    {
      name: 'Facebook',
      icon: Facebook,
      color: 'text-blue-600',
      url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(post.poster_url || 'https://vaaniai.io')}&quote=${encodedCaption}`
    },
    {
      name: 'Twitter / X',
      icon: Twitter,
      color: 'text-gray-800',
      url: `https://twitter.com/intent/tweet?text=${encodedText}`
    }
  ];

  const handleShareClick = (platform, url) => {
    window.open(url, '_blank', 'width=600,height=500');
    onShared?.(platform.toLowerCase());
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-2 bg-blue-600 hover:bg-blue-700">
          <Share2 className="w-4 h-4" /> Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {shareLinks.map(link => (
          <DropdownMenuItem key={link.name} onClick={() => handleShareClick(link.name, link.url)} className="gap-3 cursor-pointer">
            <link.icon className={`w-4 h-4 ${link.color}`} />
            {link.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopy} className="gap-3 cursor-pointer">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-gray-500" />}
          {copied ? 'Copied!' : 'Copy Caption'}
        </DropdownMenuItem>
        {post.poster_url && (
          <DropdownMenuItem onClick={handleDownload} className="gap-3 cursor-pointer">
            <Download className="w-4 h-4 text-purple-600" />
            Download Poster
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}