import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { FeedbackItem } from "@/pages/Index";
import hdfcLogo from "@/assets/hdfc-logo.png";

const ANALYSIS_CATEGORIES = [
  { id: "consistency", label: "Consistency across flows regarding UI" },
  { id: "ux", label: "UX Review" },
  { id: "ui", label: "UI Review" },
  { id: "accessibility", label: "Accessibility Issues" },
  { id: "design_system", label: "Design System Adherence" },
  { id: "ux_writing", label: "Typos & Inconsistent UX Writing" },
  { id: "high_level", label: "High Level Review About and the Why? Questioning the basics." },
];

type AnalysisFormProps = {
  onAnalysisComplete: (feedback: FeedbackItem[]) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (value: boolean) => void;
  onFileKeyExtracted: (fileKey: string) => void;
};

export const AnalysisForm = ({ onAnalysisComplete, isAnalyzing, setIsAnalyzing, onFileKeyExtracted }: AnalysisFormProps) => {
  const [figmaUrl, setFigmaUrl] = useState("");
  const [promptMode, setPromptMode] = useState<"simple" | "manual">("simple");
  const [selectedCategories, setSelectedCategories] = useState<string[]>(["consistency", "ux", "ui"]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [includeSuggestions, setIncludeSuggestions] = useState(true);
  const { toast } = useToast();

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories(prev => 
      prev.includes(categoryId) 
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  const handleAnalyze = async () => {
    if (!figmaUrl.trim()) {
      toast({
        title: "URL Required",
        description: "Please enter a Figma file URL",
        variant: "destructive",
      });
      return;
    }

    // Extract file key and node ID from URL
    // Figma URLs format: figma.com/design/fileKey/name?node-id=123:456 or ?node-id=123-456
    const urlMatch = figmaUrl.match(/(?:file|design)\/([a-zA-Z0-9_-]+)/);
    if (!urlMatch) {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid Figma file URL",
        variant: "destructive",
      });
      return;
    }

    const fileKey = urlMatch[1];
    
    // Extract node-id from query parameters
    let nodeId: string | null = null;
    try {
      const url = new URL(figmaUrl);
      const nodeIdParam = url.searchParams.get('node-id');
      if (nodeIdParam) {
        // Convert node-id format (123-456 or 123:456) to proper format
        nodeId = nodeIdParam.replace(/-/g, ':');
        console.log('Extracted node ID:', nodeId);
      }
    } catch (e) {
      console.warn('Could not parse URL for node-id:', e);
    }

    // Validation for Simple mode
    if (promptMode === "simple" && selectedCategories.length === 0) {
      toast({
        title: "Select Categories",
        description: "Please select at least one analysis category",
        variant: "destructive",
      });
      return;
    }

    // Validation for Manual mode
    if (promptMode === "manual" && !customPrompt.trim()) {
      toast({
        title: "Custom Prompt Required",
        description: "Please enter a custom prompt for analysis",
        variant: "destructive",
      });
      return;
    }

    setIsAnalyzing(true);
    onFileKeyExtracted(fileKey);
    
    // Generate prompt based on mode
    let finalPrompt = "";
    if (promptMode === "simple") {
      const categoryLabels = selectedCategories
        .map(id => ANALYSIS_CATEGORIES.find(cat => cat.id === id)?.label)
        .join(", ");
      finalPrompt = `I am a UI UX designer who lacks attention to detail and makes a lot of mistakes. Act as my manager and reviewer. Provide me feedback on the following areas: ${categoryLabels}`;
      if (includeSuggestions) {
        finalPrompt += ". For each issue, provide specific actionable suggestions on how to fix it.";
      }
    } else {
      finalPrompt = customPrompt;
      if (includeSuggestions) {
        finalPrompt += " For each issue, provide specific actionable suggestions on how to fix it.";
      }
    }

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-figma`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ 
            fileKey, 
            nodeId,
            customPrompt: finalPrompt,
            includeSuggestions,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Analysis failed");
      }

      const data = await response.json();
      onAnalysisComplete(data.feedback);
      
      toast({
        title: "Analysis Complete!",
        description: `Found ${data.feedback.length} insights. Comments added to Figma.`,
      });
    } catch (error) {
      console.error("Analysis error:", error);
      toast({
        title: "Analysis Failed",
        description: "Unable to analyze the Figma file. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-2">Start Analysis</h2>
        <p className="text-sm text-muted-foreground">
          Analyze specific pages or entire files with customizable feedback
        </p>
      </div>

      <div className="space-y-4">
        {/* Figma URL Input */}
        <div className="space-y-2">
          <Label htmlFor="figma-url" className="text-foreground">
            Figma URL
          </Label>
          <Input
            id="figma-url"
            type="url"
            placeholder="https://www.figma.com/design/..."
            value={figmaUrl}
            onChange={(e) => setFigmaUrl(e.target.value)}
            disabled={isAnalyzing}
            className="bg-background border-border focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            Paste a link to a file, page, or specific frame
          </p>
        </div>

        {/* Prompt Customization */}
        <div className="space-y-3">
          <Label className="text-foreground">Analysis Focus</Label>
          <Tabs value={promptMode} onValueChange={(v) => setPromptMode(v as "simple" | "manual")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="simple">Simple</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>
            
            <TabsContent value="simple" className="space-y-3 mt-3">
              <p className="text-sm text-muted-foreground">
                Choose what to review:
              </p>
              <div className="space-y-2.5">
                {ANALYSIS_CATEGORIES.map((category) => (
                  <div key={category.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={category.id}
                      checked={selectedCategories.includes(category.id)}
                      onCheckedChange={() => toggleCategory(category.id)}
                      disabled={isAnalyzing}
                    />
                    <Label
                      htmlFor={category.id}
                      className="text-sm font-normal cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {category.label}
                    </Label>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <Label htmlFor="suggestions" className="text-sm font-normal">
                  Include specific suggestions for fixing each issue
                </Label>
                <Switch
                  id="suggestions"
                  checked={includeSuggestions}
                  onCheckedChange={setIncludeSuggestions}
                  disabled={isAnalyzing}
                />
              </div>
            </TabsContent>
            
            <TabsContent value="manual" className="space-y-3 mt-3">
              <p className="text-sm text-muted-foreground">
                Write your custom analysis prompt:
              </p>
              <Textarea
                placeholder="Example: Focus on mobile responsiveness and button states. Check if all CTAs are clearly visible..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                disabled={isAnalyzing}
                className="min-h-[120px] bg-background border-border focus:ring-primary"
              />

              <div className="flex items-center justify-between pt-4 border-t">
                <Label htmlFor="suggestions-manual" className="text-sm font-normal">
                  Include specific suggestions for fixing each issue
                </Label>
                <Switch
                  id="suggestions-manual"
                  checked={includeSuggestions}
                  onCheckedChange={setIncludeSuggestions}
                  disabled={isAnalyzing}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <Button 
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className="w-full bg-gradient-to-r from-primary to-primary/90 hover:opacity-90 transition-opacity"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analyzing Design...
            </>
          ) : (
            <>
              <img src={hdfcLogo} alt="HDFC" className="mr-2 h-4 w-4 object-contain" />
              Analyze with AI
            </>
          )}
        </Button>
      </div>
    </div>
  );
};
