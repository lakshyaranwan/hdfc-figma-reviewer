import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle, Lightbulb, Loader2, Target } from "lucide-react";
import { FeedbackItem } from "@/pages/Index";

type FeedbackDisplayProps = {
  feedback: FeedbackItem[];
  isAnalyzing: boolean;
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
};

const severityConfig = {
  low: { label: "Low", color: "bg-muted text-muted-foreground" },
  medium: { label: "Medium", color: "bg-warning/20 text-warning-foreground" },
  high: { label: "High", color: "bg-destructive/20 text-destructive" },
};

export const FeedbackDisplay = ({ feedback, isAnalyzing }: FeedbackDisplayProps) => {
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
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">
          Analysis Results
        </h2>
        <Badge variant="secondary" className="text-sm">
          {feedback.length} insights found
        </Badge>
      </div>

      {Object.entries(groupedFeedback).map(([category, items]) => {
        const config = categoryConfig[category as keyof typeof categoryConfig];
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
                      {item.title}
                    </h4>
                    <Badge 
                      variant="secondary" 
                      className={severityConfig[item.severity].color}
                    >
                      {severityConfig[item.severity].label}
                    </Badge>
                  </div>
                  
                  <p className="text-sm text-muted-foreground leading-relaxed mb-2">
                    {item.description}
                  </p>

                  {item.location && (
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
