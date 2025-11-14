import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle, Lightbulb, Loader2, Target, MessageSquare } from "lucide-react";
import { FeedbackItem } from "@/pages/Index";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

type FeedbackDisplayProps = {
  feedback: FeedbackItem[];
  isAnalyzing: boolean;
  fileKey?: string;
};

const categoryConfig = {
  ux: {
    label: "UX Issue",
    icon: Target,
    color: "bg-primary/10 text-primary border-primary/20",
  },
  ui: {
    label: "UI Issue",
    icon: AlertCircle,
    color: "bg-warning/10 text-warning border-warning/20",
  },
  consistency: {
    label: "Consistency",
    icon: CheckCircle,
    color: "bg-destructive/10 text-destructive border-destructive/20",
  },
  improvement: {
    label: "Improvement",
    icon: Lightbulb,
    color: "bg-accent/10 text-accent border-accent/20",
  },
  accessibility: {
    label: "Accessibility",
    icon: AlertCircle,
    color: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  },
  design_system: {
    label: "Design System",
    icon: CheckCircle,
    color: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  },
  high_level: {
    label: "High Level",
    icon: Lightbulb,
    color: "bg-green-500/10 text-green-500 border-green-500/20",
  },
};

const severityConfig = {
  low: { label: "Low", color: "bg-muted text-muted-foreground" },
  medium: { label: "Medium", color: "bg-warning/20 text-warning-foreground" },
  high: { label: "High", color: "bg-destructive/20 text-destructive" },
};

export const FeedbackDisplay = ({ feedback, isAnalyzing, fileKey }: FeedbackDisplayProps) => {
  const { toast } = useToast();
  const [isPostingComments, setIsPostingComments] = useState(false);

  const handlePostComments = async () => {
    if (!fileKey) {
      toast({
        title: "No File Selected",
        description: "Please analyze a Figma file first",
        variant: "destructive",
      });
      return;
    }

    setIsPostingComments(true);
    
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/post-figma-comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileKey, feedback }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to post comments");
      }

      const data = await response.json();
      
      toast({
        title: "Comments Posted!",
        description: `Successfully added ${data.commentsPosted} comments to your Figma file`,
      });
    } catch (error) {
      console.error("Error posting comments:", error);
      toast({
        title: "Failed to Post Comments",
        description: "Unable to add comments to Figma. Please check your token permissions.",
        variant: "destructive",
      });
    } finally {
      setIsPostingComments(false);
    }
  };
  if (isAnalyzing) {
    return (
      <Card className="p-12 text-center shadow-[var(--shadow-card)]">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-primary" />
        <h3 className="text-lg font-semibold text-foreground mb-2">Analyzing Your Design</h3>
        <p className="text-sm text-muted-foreground">
          AI is reviewing flows, screens, and consistency patterns...
        </p>
      </Card>
    );
  }

  if (feedback.length === 0) {
    return (
      <Card className="p-12 text-center shadow-[var(--shadow-card)]">
        <div className="w-16 h-16 rounded-full bg-muted mx-auto mb-4 flex items-center justify-center">
          <Target className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">No Analysis Yet</h3>
        <p className="text-sm text-muted-foreground">
          Enter a Figma file URL and click "Analyze with AI" to get started
        </p>
      </Card>
    );
  }

  const groupedFeedback = feedback.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, FeedbackItem[]>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-foreground">
            Analysis Results
          </h2>
          <Badge variant="secondary" className="text-sm">
            {feedback.length} insights found
          </Badge>
        </div>
        
        {fileKey && feedback.length > 0 && (
          <Button
            onClick={handlePostComments}
            disabled={isPostingComments}
            className="bg-accent hover:bg-accent/90"
          >
            {isPostingComments ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Posting...
              </>
            ) : (
              <>
                <MessageSquare className="mr-2 h-4 w-4" />
                Add Comments to Figma
              </>
            )}
          </Button>
        )}
      </div>

      {Object.entries(groupedFeedback).map(([category, items]) => {
        const config = categoryConfig[category as keyof typeof categoryConfig];
        
        // Safety check: skip if category config doesn't exist
        if (!config) {
          console.warn(`Unknown feedback category: ${category}`);
          return null;
        }
        
        const Icon = config.icon;

        return (
          <div key={category} className="space-y-3">
            <div className="flex items-center gap-2">
              <Icon className="w-5 h-5 text-muted-foreground" />
              <h3 className="font-medium text-foreground">{config.label}</h3>
              <Badge variant="outline" className="ml-auto">
                {items.length}
              </Badge>
            </div>

            <div className="space-y-3">
              {items.map((item) => (
                <Card 
                  key={item.id} 
                  className="p-4 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-hover)] transition-all duration-200 border-l-4"
                  style={{
                    borderLeftColor: `hsl(var(--${category === 'ux' ? 'primary' : category === 'ui' ? 'warning' : category === 'consistency' ? 'destructive' : 'accent'}))`
                  }}
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <h4 className="font-medium text-foreground leading-tight">
                      {item.title.replace(/\[[\d:;]+\]/g, '').replace(/\([\d:;]+\)/g, '').trim()}
                    </h4>
                    <Badge 
                      variant="secondary" 
                      className={severityConfig[item.severity].color}
                    >
                      {severityConfig[item.severity].label}
                    </Badge>
                  </div>
                  
                  <p className="text-sm text-muted-foreground leading-relaxed mb-2">
                    {item.description.replace(/\[[\d:;]+\]/g, '').replace(/\([\d:;]+\)/g, '').trim()}
                  </p>

                  {item.location && !item.location.match(/[0-9]+:[0-9]+/) && (
                    <div className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
                      Location: {item.location}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
