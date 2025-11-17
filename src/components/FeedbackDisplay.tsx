import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertCircle, CheckCircle, Lightbulb, Loader2, Target, MessageSquare, ChevronDown, Sparkles } from "lucide-react";
import { FeedbackItem } from "@/pages/Index";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

type FeedbackDisplayProps = {
  feedback: FeedbackItem[];
  isAnalyzing: boolean;
  fileKey?: string;
};

interface SolutionItem extends FeedbackItem {
  solution: string;
  implementation_steps: string[];
}

const categoryConfig = {
  consistency: {
    label: "Consistency across flows regarding UI",
    icon: CheckCircle,
    color: "bg-destructive/10 text-destructive border-destructive/20",
  },
  ux: {
    label: "UX Review",
    icon: Target,
    color: "bg-primary/10 text-primary border-primary/20",
  },
  ui: {
    label: "UI Review",
    icon: AlertCircle,
    color: "bg-warning/10 text-warning border-warning/20",
  },
  accessibility: {
    label: "Accessibility Issues",
    icon: AlertCircle,
    color: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  },
  design_system: {
    label: "Design System Adherence",
    icon: CheckCircle,
    color: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  },
  ux_writing: {
    label: "Typos & Inconsistent UX Writing",
    icon: MessageSquare,
    color: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  },
  high_level: {
    label: "High Level Review About and the Why? Questioning the basics.",
    icon: Lightbulb,
    color: "bg-green-500/10 text-green-500 border-green-500/20",
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

export const FeedbackDisplay = ({ feedback, isAnalyzing, fileKey }: FeedbackDisplayProps) => {
  const { toast } = useToast();
  const [isPostingComments, setIsPostingComments] = useState(false);
  const [isGeneratingSolutions, setIsGeneratingSolutions] = useState(false);
  const [solutions, setSolutions] = useState<SolutionItem[]>([]);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [hideLowSeverity, setHideLowSeverity] = useState(false);

  const toggleSection = (category: string) => {
    setOpenSections(prev => ({
      ...prev,
      [category]: !prev[category]
    }));
  };

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
      // Filter out low severity issues if the toggle is enabled
      const feedbackToPost = hideLowSeverity 
        ? feedback.filter(item => item.severity !== "low")
        : feedback;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/post-figma-comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileKey, feedback: feedbackToPost }),
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

  const handleGenerateSolutions = async () => {
    if (!fileKey || feedback.length === 0) {
      toast({
        title: "No Feedback Available",
        description: "Please analyze a Figma file first to generate solutions",
        variant: "destructive",
      });
      return;
    }

    setIsGeneratingSolutions(true);
    
    try {
      const feedbackToProcess = hideLowSeverity 
        ? feedback.filter(item => item.severity !== "low")
        : feedback;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-figma-solutions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ feedback: feedbackToProcess, fileKey }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to generate solutions");
      }

      const data = await response.json();
      setSolutions(data.solutions);
      
      toast({
        title: "Solutions Generated!",
        description: `AI has generated ${data.solutions.length} detailed solutions for your feedback`,
      });
    } catch (error) {
      console.error("Error generating solutions:", error);
      toast({
        title: "Failed to Generate Solutions",
        description: "Unable to generate AI-powered solutions. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingSolutions(false);
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

  // Filter feedback based on severity toggle
  const filteredFeedback = hideLowSeverity 
    ? feedback.filter(item => item.severity !== "low")
    : feedback;

  const groupedFeedback = filteredFeedback.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, FeedbackItem[]>);

  // Define the display order to match checkbox order
  const categoryOrder = [
    "consistency",
    "ux", 
    "ui",
    "accessibility",
    "design_system",
    "ux_writing",
    "high_level",
    "improvement"
  ];

  // Sort categories according to the defined order
  const sortedCategories = categoryOrder
    .filter(category => groupedFeedback[category] && groupedFeedback[category].length > 0)
    .map(category => [category, groupedFeedback[category]] as [string, FeedbackItem[]]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-foreground">
            Analysis Results
          </h2>
          <Badge variant="secondary" className="text-sm">
            {filteredFeedback.length} insights found
          </Badge>
        </div>
        
        {fileKey && feedback.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
            <Button
              onClick={handleGenerateSolutions}
              disabled={isGeneratingSolutions}
              variant="outline"
              className="border-primary/20 hover:bg-primary/10"
            >
              {isGeneratingSolutions ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Generate AI Solutions
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Filter Controls */}
      {feedback.length > 0 && (
        <Card className="p-4 bg-muted/30">
          <div className="flex items-center gap-3">
            <Switch
              id="hide-low-severity"
              checked={hideLowSeverity}
              onCheckedChange={setHideLowSeverity}
            />
            <Label htmlFor="hide-low-severity" className="cursor-pointer">
              Hide low severity issues
            </Label>
            {hideLowSeverity && (
              <Badge variant="outline" className="ml-auto">
                {feedback.length - filteredFeedback.length} hidden
              </Badge>
            )}
          </div>
        </Card>
      )}

      {sortedCategories.map(([category, items]) => {
        const config = categoryConfig[category as keyof typeof categoryConfig];
        
        // Safety check: skip if category config doesn't exist
        if (!config) {
          console.warn(`Unknown feedback category: ${category}`);
          return null;
        }
        
        const Icon = config.icon;

        return (
          <Collapsible
            key={category}
            open={openSections[category] !== false}
            onOpenChange={() => toggleSection(category)}
          >
            <Card className="overflow-hidden shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-hover)] transition-shadow">
              <CollapsibleTrigger className="w-full">
                <div className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/50 transition-colors">
                  <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                  <h3 className="font-medium text-foreground text-left">{config.label}</h3>
                  <Badge variant="outline" className="ml-auto">
                    {items.length}
                  </Badge>
                  <ChevronDown 
                    className={`w-4 h-4 text-muted-foreground transition-transform ${
                      openSections[category] !== false ? 'rotate-180' : ''
                    }`}
                  />
                </div>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <div className="p-4 pt-0 space-y-3">
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

                      {/* AI Generated Solution */}
                      {solutions.length > 0 && (() => {
                        const solution = solutions.find(s => s.id === item.id);
                        if (!solution) return null;
                        
                        return (
                          <div className="mt-4 pt-4 border-t border-primary/20 bg-primary/5 -mx-4 -mb-4 p-4 rounded-b-lg">
                            <div className="flex items-center gap-2 mb-3">
                              <Sparkles className="w-4 h-4 text-primary" />
                              <h5 className="font-semibold text-sm text-primary">AI-Generated Solution</h5>
                            </div>
                            
                            <p className="text-sm text-foreground mb-3 leading-relaxed">
                              {solution.solution}
                            </p>
                            
                            {solution.implementation_steps && solution.implementation_steps.length > 0 && (
                              <div className="space-y-2">
                                <h6 className="font-medium text-xs text-muted-foreground uppercase tracking-wide">Implementation Steps:</h6>
                                <ol className="space-y-2 text-sm text-foreground">
                                  {solution.implementation_steps.map((step, idx) => (
                                    <li key={idx} className="flex gap-2">
                                      <span className="font-semibold text-primary flex-shrink-0">{idx + 1}.</span>
                                      <span>{step}</span>
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </Card>
                  ))}
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}
    </div>
  );
};
